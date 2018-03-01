import * as React from 'react';
import ApolloClient, { PureQueryOptions, ApolloError } from 'apollo-client';
import { DataProxy } from 'apollo-cache';
import { DocumentNode, GraphQLError } from 'graphql';
import { ApolloConsumer as Consumer } from './Context';

const invariant = require('invariant');
const shallowEqual = require('fbjs/lib/shallowEqual');

import { OperationVariables, RefetchQueriesProviderFn } from './types';
import { parser, DocumentType } from './parser';

export interface MutationResult<TData = Record<string, any>> {
  data?: TData;
  error?: ApolloError;
  loading?: boolean;
}

export interface ExecutionResult<T = Record<string, any>> {
  data?: T;
  extensions?: Record<string, any>;
  errors?: GraphQLError[];
}

// Improved MutationUpdaterFn type, need to port them back to Apollo Client
export declare type MutationUpdaterFn<
  T = {
    [key: string]: any;
  }
> = (proxy: DataProxy, mutationResult: FetchResult<T>) => void;

export declare type FetchResult<C = Record<string, any>, E = Record<string, any>> = ExecutionResult<
  C
> & {
  extensions?: E;
  context?: C;
};

export declare type MutationOptions<TData = any, TVariables = OperationVariables> = {
  variables?: TVariables;
  optimisticResponse?: Object;
  refetchQueries?: string[] | PureQueryOptions[] | RefetchQueriesProviderFn;
  update?: MutationUpdaterFn<TData>;
};

export interface MutationProps<TData = any, TVariables = OperationVariables> {
  mutation: DocumentNode;
  ignoreResults?: boolean;
  optimisticResponse?: Object;
  variables?: TVariables;
  refetchQueries?: string[] | PureQueryOptions[] | RefetchQueriesProviderFn;
  update?: MutationUpdaterFn<TData>;
  children: (
    mutateFn: (options?: MutationOptions<TData, TVariables>) => Promise<void | FetchResult>,
    result?: MutationResult<TData>,
  ) => React.ReactNode;
  onCompleted?: (data: TData) => void;
  onError?: (error: ApolloError) => void;
}

export interface MutationState<TData = any> {
  notCalled: boolean;
  error?: ApolloError;
  data?: TData;
  loading?: boolean;
  client: ApolloClient<any>;
}

export interface InnerMutationProps<TData = any, TVariables = OperationVariables>
  extends MutationProps<TData, TVariables> {
  client: ApolloClient<any>;
}

class Mutation<TData = any, TVariables = OperationVariables> extends React.Component<
  InnerMutationProps<TData, TVariables>,
  MutationState<TData>
> {
  private mostRecentMutationId: number;
  static getDerivedStateFromProps = (
    nextProps: InnerMutationProps<any, any>,
    prevState: MutationState<any>,
  ) => {
    if (nextProps.client !== prevState.client) {
      return {
        notCalled: true,
        client: nextProps.client,
      };
    }
    return null;
  };
  constructor(props: InnerMutationProps<TData, TVariables>) {
    super(props);

    this.verifyDocumentIsMutation(props.mutation);

    this.mostRecentMutationId = 0;
    this.state = { notCalled: true, client: props.client };
  }

  componentDidUpdate(prevProps: InnerMutationProps<TData, TVariables>) {
    if (shallowEqual(this.props, prevProps)) return;

    if (this.props.mutation !== prevProps.mutation) {
      this.verifyDocumentIsMutation(this.props.mutation);
    }
  }

  render() {
    const { children } = this.props;
    const { loading, data, error, notCalled } = this.state;

    const result = notCalled
      ? undefined
      : {
          loading,
          data,
          error,
        };

    return children(this.runMutation, result);
  }

  private runMutation = (options: MutationOptions<TVariables> = {}) => {
    this.onStartMutation();

    const mutationId = this.generateNewMutationId();

    return this.mutate(options)
      .then(response => {
        this.onCompletedMutation(response, mutationId);
        return response;
      })
      .catch(e => {
        this.onMutationError(e, mutationId);
        if (!this.props.onError) throw e;
      });
  };

  private mutate = (options: MutationOptions<TVariables>) => {
    const { mutation, variables, optimisticResponse, update } = this.props;
    let refetchQueries = options.refetchQueries || this.props.refetchQueries;

    return this.state.client.mutate({
      mutation,
      variables,
      optimisticResponse,
      refetchQueries,
      update,
      ...options,
    });
  };

  private onStartMutation = () => {
    if (!this.state.loading && !this.props.ignoreResults) {
      this.setState({
        loading: true,
        error: undefined,
        data: undefined,
        notCalled: false,
      });
    }
  };

  private onCompletedMutation = (response: ExecutionResult<TData>, mutationId: number) => {
    const { onCompleted, ignoreResults } = this.props;

    const data = response.data as TData;

    const callOncomplete = () => (onCompleted ? onCompleted(data) : null);

    if (this.isMostRecentMutation(mutationId) && !ignoreResults) {
      this.setState({ loading: false, data }, callOncomplete);
    } else {
      callOncomplete();
    }
  };

  private onMutationError = (error: ApolloError, mutationId: number) => {
    const { onError } = this.props;

    const callOnError = () => (onError ? onError(error) : null);

    if (this.isMostRecentMutation(mutationId)) {
      this.setState({ loading: false, error }, callOnError);
    } else {
      callOnError();
    }
  };

  private generateNewMutationId = (): number => {
    this.mostRecentMutationId = this.mostRecentMutationId + 1;
    return this.mostRecentMutationId;
  };

  private isMostRecentMutation = (mutationId: number) => {
    return this.mostRecentMutationId === mutationId;
  };

  private verifyDocumentIsMutation = (mutation: DocumentNode) => {
    const operation = parser(mutation);
    invariant(
      operation.type === DocumentType.Mutation,
      `The <Mutation /> component requires a graphql mutation, but got a ${
        operation.type === DocumentType.Query ? 'query' : 'subscription'
      }.`,
    );
  };
}

export default class ApolloMutation<
  TData = any,
  TVariables = OperationVariables
> extends React.Component<MutationProps<TData, TVariables>> {
  render() {
    return <Consumer>{client => <Mutation client={client} {...this.props} />}</Consumer>;
  }
}
