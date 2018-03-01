import * as React from 'react';
import ApolloClient, { ApolloError } from 'apollo-client';
import { DocumentNode } from 'graphql';
import { ZenObservable } from 'zen-observable-ts';
import { ApolloConsumer as Consumer } from './Context';
import { OperationVariables } from './types';

const shallowEqual = require('fbjs/lib/shallowEqual');
const invariant = require('invariant');

export interface SubscriptionResult<TData = any> {
  loading: boolean;
  data?: TData;
  error?: ApolloError;
}

export interface SubscriptionProps<TData = any, TVariables = OperationVariables> {
  query: DocumentNode;
  variables?: TVariables;
  shouldResubscribe?: boolean;
  children: (result: SubscriptionResult<TData>) => React.ReactNode;
}

export interface SubscriptionState<TData = any> {
  loading: boolean;
  data?: TData;
  error?: ApolloError;
  client: ApolloClient;
  props: SubscriptionProps;
}

const getInitialState = props => ({
  loading: true,
  error: undefined,
  data: undefined,
  props,
});

class Subscription<TData = any, TVariables = any> extends React.Component<
  SubscriptionProps<TData, TVariables>,
  SubscriptionState<TData>
> {
  private queryObservable: ZenObservable.Observable<any>;
  private querySubscription: ZenObservable.Subscription;

  static getDerivedStateFromProps(
    nextProps: SubscriptionProps<TData, TVariables>,
    prevState: SubscriptionState,
  ) {
    const shouldNotResubscribe = prevState.props.shouldResubscribe === false;
    if (shallowEqual(nextProps, prevState.props) || shouldNotResubscribe) {
      return null;
    }

    return getInitialState(nextProps);
  }

  constructor(props: SubscriptionProps<TData, TVariables>) {
    super(props);

    this.initialize(props);
    this.state = getInitialState(props);
  }

  componentDidMount() {
    this.startSubscription();
  }

  componentDidUpdate(prevProps: SubscriptionProps<TData, TVariables>) {
    if (shallowEqual(this.props, prevProps)) return;
    const shouldNotResubscribe = prevProps.shouldResubscribe === false;

    if (!shouldNotResubscribe) {
      this.endSubscription();
      delete this.queryObservable;
      this.initialize(this.props);
      this.startSubscription();
      return;
    }
    this.initialize(this.props);
    this.startSubscription();
  }

  componentWillUnmount() {
    this.endSubscription();
  }

  render() {
    const result = Object.assign({}, this.state, {
      variables: this.props.variables,
    });
    return this.props.children(result);
  }

  private initialize = (props: SubscriptionProps<TData, TVariables>) => {
    if (this.queryObservable) return;
    this.queryObservable = props.client.subscribe({
      query: props.query,
      variables: props.variables,
    });
  };

  private startSubscription = () => {
    if (this.querySubscription) return;
    this.querySubscription = this.queryObservable.subscribe({
      next: this.updateCurrentData,
      error: this.updateError,
    });
  };

  private updateCurrentData = (result: SubscriptionResult<TData>) => {
    this.setState({ data: result.data, loading: false, error: undefined });
  };

  private updateError = (error: any) => {
    this.setState({
      error,
      loading: false,
    });
  };

  private endSubscription = () => {
    if (this.querySubscription) {
      this.querySubscription.unsubscribe();
      delete this.querySubscription;
    }
  };
}

export default class ApolloSubscription extends React.Component {
  render() {
    return <Consumer>{client => <Subscription client={client} {...this.props} />}</Consumer>;
  }
}
